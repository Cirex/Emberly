import Image from "next/image";
import { AdminButton } from "./admin-ui";

type AdminLoginSectionProps = {
  error?: string;
  returnTo?: string;
};

export function adminLoginErrorMessage(errorCode?: string): string {
  return errorCode === "rate_limited"
    ? "Too many login attempts. Try again shortly."
    : errorCode === "invalid"
      ? "Invalid ResMan credentials."
      : "";
}

export function AdminLoginSection({ error = "", returnTo = "/admin/login" }: AdminLoginSectionProps) {
  return (
    <main
      className="flex min-h-screen items-center justify-center p-4 sm:p-6"
      style={{
        background:
          "radial-gradient(1100px 520px at 50% -8%, rgb(38 52 138 / 0.12), var(--color-cream))",
      }}
    >
      <section className="card w-full max-w-md rounded-2xl px-6 py-9 text-center sm:px-10 sm:py-11">
        <div className="mx-auto flex justify-center">
          <Image
            src="/logo.jpg"
            alt="Emberly Apartments"
            width={375}
            height={250}
            priority
            className="h-auto w-full max-w-[220px] object-contain"
          />
        </div>

        <div className="mx-auto mt-5 max-w-md">
          <p className="admin-kicker tracking-[0.14em]">Admin Portal</p>
          <p className="mt-2 text-sm text-muted sm:text-base">Sign in with your ResMan staff credentials.</p>
        </div>

        <form action="/api/admin/auth" method="post" className="mx-auto mt-8 max-w-md space-y-4 text-left">
          <input type="hidden" name="returnTo" value={returnTo} />
          <div>
            <label htmlFor="username" className="mb-2 block text-sm font-semibold text-primary">
              ResMan Username
            </label>
            <input
              id="username"
              name="username"
              type="text"
              placeholder="ResMan username"
              autoComplete="username"
              className="admin-input w-full"
            />
          </div>
          <div>
            <label htmlFor="password" className="mb-2 block text-sm font-semibold text-primary">
              ResMan Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              placeholder="ResMan password"
              autoComplete="current-password"
              className="admin-input w-full"
            />
          </div>

          <details className="text-left">
            <summary className="cursor-pointer text-xs font-semibold text-muted">Use emergency key</summary>
            <input
              id="breakGlass"
              name="breakGlass"
              type="password"
              placeholder="Break-glass key"
              autoComplete="off"
              className="admin-input mt-2 w-full"
            />
          </details>

          {error ? (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
          ) : null}

          <AdminButton type="submit" icon="shield" className="w-full">
            Sign In
          </AdminButton>
        </form>
      </section>
    </main>
  );
}
