"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import { api } from "@convex/_generated/api";
import { isSupportedLang, type MessageKey } from "@/i18n/messages";
import { useI18n } from "@/i18n/provider";
import {
  BackButton,
  BrandHeader,
  ChoicePill,
  PrimaryButton,
  Screen,
  TextField,
} from "@/components/ui";

type Mode = "signUp" | "logIn";
type Gender = "female" | "male" | "unspecified";
type Submitted = { kind: "signUp"; gender: Gender } | { kind: "logIn" } | null;
type FieldName = "name" | "email" | "password" | "gender" | "form";
type Errors = Partial<Record<FieldName, MessageKey>>;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MIN_PASSWORD = 8;

const GENDERS: ReadonlyArray<{ value: Gender; label: MessageKey }> = [
  { value: "female", label: "auth.genderFemale" },
  { value: "male", label: "auth.genderMale" },
  { value: "unspecified", label: "auth.genderUnspecified" },
];

function mapAuthError(err: unknown, mode: Mode): MessageKey {
  const msg = err instanceof Error ? err.message : String(err);
  if (/already exists|already in use/i.test(msg)) return "err.emailTaken";
  if (/invalid password/i.test(msg)) return "err.passwordShort";
  if (/invalid credentials|InvalidAccountId|InvalidSecret/i.test(msg)) {
    return "err.invalidCredentials";
  }
  // Production Convex masks server errors as "Server Error"; a failed
  // sign-in is by far the most likely cause there.
  if (mode === "logIn" && /server error/i.test(msg)) return "err.invalidCredentials";
  return "err.generic";
}

export default function AuthPage() {
  const router = useRouter();
  const { t, lang, setLang } = useI18n();
  const { signIn } = useAuthActions();
  const { isAuthenticated } = useConvexAuth();
  // "skip" until authenticated so we never read a stale signed-out `null`.
  const me = useQuery(api.users.me, isAuthenticated ? {} : "skip");
  const updateProfile = useMutation(api.users.updateProfile);

  const [mode, setMode] = useState<Mode>("signUp");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [gender, setGender] = useState<Gender | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState<Submitted>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const nameRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const savingRef = useRef(false);

  // Arrived already signed in (and not mid-signup): nothing to do here.
  useEffect(() => {
    if (isAuthenticated && submitted === null) router.replace("/start");
  }, [isAuthenticated, submitted, router]);

  // After a successful sign-in, once the session is confirmed by the server:
  // sign-up saves language + gender; log-in restores the saved language.
  useEffect(() => {
    if (submitted === null || !isAuthenticated || me === undefined) return;
    if (savingRef.current) return;
    savingRef.current = true;

    const finish = async () => {
      try {
        // Convex Auth treats "sign up with an existing email + correct
        // password" as a sign-in. That account already has a profile: keep it.
        if (submitted.kind === "signUp" && !me?.primaryLanguage) {
          await updateProfile({
            knownLanguages: [lang],
            primaryLanguage: lang,
            // Placeholder so the profile is valid at sign-up; the "What do you
            // want to learn?" screen (/learn) replaces it with the real choice.
            targetLanguage: lang === "en" ? "de" : "en",
            gender: submitted.gender,
          });
          router.replace("/intro");
          return;
        }
        if (me?.primaryLanguage) {
          if (isSupportedLang(me.primaryLanguage)) setLang(me.primaryLanguage);
        } else {
          // Account exists but sign-up never finished saving its profile.
          await updateProfile({
            knownLanguages: [lang],
            primaryLanguage: lang,
            targetLanguage: lang === "en" ? "de" : "en",
            gender: me?.gender ?? "unspecified",
          });
        }
        router.replace("/start");
      } catch {
        setSaveFailed(true);
        savingRef.current = false;
      }
    };
    void finish();
    // `lang` is read once when saving starts; it must not restart the save.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submitted, isAuthenticated, me, attempt]);

  function clearError(...fields: FieldName[]) {
    setErrors((prev) => {
      if (!fields.some((f) => prev[f])) return prev;
      const next = { ...prev };
      for (const f of fields) delete next[f];
      return next;
    });
  }

  function switchMode(next: Mode) {
    if (busy || next === mode) return;
    setMode(next);
    setErrors({});
  }

  function validate(): Errors {
    const found: Errors = {};
    if (mode === "signUp" && name.trim().length === 0) found.name = "err.nameRequired";
    if (!EMAIL_RE.test(email.trim())) found.email = "err.emailInvalid";
    if (mode === "signUp") {
      if (password.length < MIN_PASSWORD) found.password = "err.passwordShort";
      if (gender === null) found.gender = "err.genderRequired";
    } else if (password.length === 0) {
      found.password = "err.passwordRequired";
    }
    return found;
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;

    const found = validate();
    if (Object.keys(found).length > 0) {
      setErrors(found);
      if (found.name) nameRef.current?.focus();
      else if (found.email) emailRef.current?.focus();
      else if (found.password) passwordRef.current?.focus();
      return;
    }

    setErrors({});
    setBusy(true);
    const cleanEmail = email.trim().toLowerCase();
    try {
      if (mode === "signUp") {
        await signIn("password", {
          flow: "signUp",
          email: cleanEmail,
          password,
          name: name.trim(),
        });
        setSubmitted({ kind: "signUp", gender: gender ?? "unspecified" });
      } else {
        await signIn("password", { flow: "signIn", email: cleanEmail, password });
        setSubmitted({ kind: "logIn" });
      }
    } catch (err) {
      setErrors({ form: mapAuthError(err, mode) });
      setBusy(false);
    }
  }

  const isSignUp = mode === "signUp";
  const err = (field: FieldName) => (errors[field] ? t(errors[field]) : null);

  return (
    <Screen>
      <div className="relative">
        <BackButton onClick={() => router.push("/")} />
        <BrandHeader />
      </div>

      <div
        role="group"
        aria-label={t("auth.tabsLabel")}
        className="mt-8 grid grid-cols-2 gap-1 rounded-2xl border border-line bg-surface p-1"
      >
        {(["signUp", "logIn"] as const).map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={mode === m}
            onClick={() => switchMode(m)}
            className={
              "h-12 rounded-xl text-base font-semibold transition-colors " +
              (mode === m
                ? "bg-accent text-accent-ink"
                : "text-fg hover:bg-surface-2")
            }
          >
            {t(m === "signUp" ? "auth.tabSignUp" : "auth.tabLogIn")}
          </button>
        ))}
      </div>

      <form onSubmit={onSubmit} noValidate className="mt-6 flex flex-col gap-5">
        {isSignUp ? (
          <TextField
            ref={nameRef}
            label={t("auth.name")}
            placeholder={t("auth.namePlaceholder")}
            autoComplete="name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              clearError("name", "form");
            }}
            error={err("name")}
            maxLength={80}
          />
        ) : null}

        <TextField
          ref={emailRef}
          label={t("auth.email")}
          placeholder={t("auth.emailPlaceholder")}
          type="email"
          inputMode="email"
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            clearError("email", "form");
          }}
          error={err("email")}
        />

        <TextField
          ref={passwordRef}
          label={t("auth.password")}
          placeholder={isSignUp ? t("auth.passwordCreate") : t("auth.passwordEnter")}
          type={showPassword ? "text" : "password"}
          autoComplete={isSignUp ? "new-password" : "current-password"}
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            clearError("password", "form");
          }}
          error={err("password")}
          hint={isSignUp ? t("auth.passwordHint") : undefined}
          trailing={
            <button
              type="button"
              onClick={() => setShowPassword((s) => !s)}
              aria-pressed={showPassword}
              aria-label={showPassword ? t("auth.hidePassword") : t("auth.showPassword")}
              className="grid size-11 place-items-center rounded-full text-muted hover:text-fg"
            >
              <EyeIcon off={showPassword} />
            </button>
          }
        />

        {isSignUp ? (
          <fieldset aria-describedby="gender-hint">
            <legend className="mb-1 text-base font-medium">{t("auth.gender")}</legend>
            <p id="gender-hint" className="mb-3 text-base text-muted">
              {t("auth.genderHint")}
            </p>
            <div className="flex flex-wrap gap-2">
              {GENDERS.map((g) => (
                <ChoicePill
                  key={g.value}
                  name="gender"
                  value={g.value}
                  checked={gender === g.value}
                  onChange={(v) => {
                    setGender(v as Gender);
                    clearError("gender");
                  }}
                >
                  {t(g.label)}
                </ChoicePill>
              ))}
            </div>
            {errors.gender ? (
              <p role="alert" className="mt-2 text-base text-danger">
                {t(errors.gender)}
              </p>
            ) : null}
          </fieldset>
        ) : null}

        {errors.form ? (
          <p role="alert" className="text-base text-danger">
            {t(errors.form)}
          </p>
        ) : null}

        {saveFailed ? (
          <div role="alert" className="rounded-2xl border border-danger/50 p-4">
            <p className="text-base text-danger">{t("err.saveProfile")}</p>
            <button
              type="button"
              onClick={() => {
                setSaveFailed(false);
                setAttempt((n) => n + 1);
              }}
              className="mt-3 h-11 rounded-xl border border-line-strong px-4 text-base font-semibold"
            >
              {t("auth.retrySave")}
            </button>
          </div>
        ) : null}

        <PrimaryButton type="submit" busy={busy}>
          {busy
            ? t(isSignUp ? "auth.creatingAccount" : "auth.loggingIn")
            : t(isSignUp ? "auth.createAccount" : "auth.logIn")}
        </PrimaryButton>
      </form>

      <div className="mt-6 flex items-center gap-3 text-base text-muted" aria-hidden="true">
        <span className="h-px flex-1 bg-line" />
        <span>{t("auth.or")}</span>
        <span className="h-px flex-1 bg-line" />
      </div>

      <button
        type="button"
        disabled
        className="mt-6 flex h-14 w-full cursor-not-allowed items-center justify-center gap-3 rounded-2xl border border-line bg-surface px-4 text-base font-medium text-muted"
      >
        <GoogleMark />
        <span>{t("auth.google")}</span>
        <span className="rounded-full border border-line-strong px-2 py-0.5 text-[13px] leading-tight text-muted">
          {t("auth.comingSoon")}
        </span>
      </button>

      {isSignUp ? (
        <p className="mt-4 text-center text-base text-muted">{t("auth.takesOneMinute")}</p>
      ) : null}
    </Screen>
  );
}

function EyeIcon({ off }: { off: boolean }) {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
      {off ? <path d="M3 3l18 18" /> : null}
    </svg>
  );
}

function GoogleMark() {
  return (
    <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true">
      <path
        fill="#EA4335"
        d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.9 2.4 30.4 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.1C12.4 13.6 17.7 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.4 5.7c4.4-4 6.9-10 6.9-17.1z"
      />
      <path
        fill="#FBBC05"
        d="M10.5 28.7c-.5-1.4-.8-3-.8-4.7s.3-3.2.8-4.7l-7.9-6.1C.9 16.4 0 20.1 0 24s.9 7.6 2.6 10.8l7.9-6.1z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.4-5.7c-2.1 1.4-4.9 2.3-8.5 2.3-6.3 0-11.6-4.1-13.5-9.8l-7.9 6.1C6.5 42.6 14.6 48 24 48z"
      />
    </svg>
  );
}
