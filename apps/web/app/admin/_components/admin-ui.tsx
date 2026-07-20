import Link from "next/link";
import type { ButtonHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";

type AdminIconName =
  | "arrow-left"
  | "activity"
  | "ban"
  | "check"
  | "chevron-left"
  | "chevron-right"
  | "eye"
  | "filter"
  | "log-out"
  | "plus"
  | "refresh"
  | "rotate"
  | "save"
  | "search"
  | "shield"
  | "unlock"
  | "x";

type ButtonVariant = "primary" | "accent" | "ghost" | "danger" | "link" | "danger-link";

function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

export function AdminIcon({ name, className }: { name: AdminIconName; className?: string }) {
  const common = cx("h-4 w-4 shrink-0", className);

  if (name === "arrow-left") {
    return (
      <svg className={common} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5 3 12m0 0 7.5-7.5M3 12h18" />
      </svg>
    );
  }

  if (name === "activity") {
    return (
      <svg className={common} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 12h3.75l2.25-6 4.5 12 2.25-6h3.75" />
      </svg>
    );
  }

  if (name === "ban") {
    return (
      <svg className={common} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M18.364 18.364A9 9 0 0 0 5.636 5.636m12.728 12.728A9 9 0 0 1 5.636 5.636m12.728 12.728 2.121 2.121M5.636 5.636 3.515 3.515" />
      </svg>
    );
  }

  if (name === "check") {
    return (
      <svg className={common} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
      </svg>
    );
  }

  if (name === "chevron-left" || name === "chevron-right") {
    return (
      <svg className={common} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d={name === "chevron-left" ? "M15.75 19.5 8.25 12l7.5-7.5" : "m8.25 4.5 7.5 7.5-7.5 7.5"}
        />
      </svg>
    );
  }

  if (name === "filter") {
    return (
      <svg className={common} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 3c2.755 0 5.455.232 8.083.678.533.09.917.556.917 1.096v1.044a2.25 2.25 0 0 1-.659 1.591l-5.432 5.432a2.25 2.25 0 0 0-.659 1.591v2.927a2.25 2.25 0 0 1-1.244 2.013L9.75 21v-6.568a2.25 2.25 0 0 0-.659-1.591L3.659 7.409A2.25 2.25 0 0 1 3 5.818V4.774c0-.54.384-1.006.917-1.096A48.32 48.32 0 0 1 12 3Z" />
      </svg>
    );
  }

  if (name === "eye") {
    return (
      <svg className={common} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12s3.75-6.75 9.75-6.75S21.75 12 21.75 12s-3.75 6.75-9.75 6.75S2.25 12 2.25 12Z" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
      </svg>
    );
  }

  if (name === "log-out") {
    return (
      <svg className={common} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0 0 13.5 3h-6A2.25 2.25 0 0 0 5.25 5.25v13.5A2.25 2.25 0 0 0 7.5 21h6a2.25 2.25 0 0 0 2.25-2.25V15m3-3H9.75m9 0-3-3m3 3-3 3" />
      </svg>
    );
  }

  if (name === "plus") {
    return (
      <svg className={common} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
      </svg>
    );
  }

  if (name === "refresh") {
    return (
      <svg className={common} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992V4.356M20.25 9A8.25 8.25 0 0 0 5.64 5.64m2.337 9.012H2.985v4.992M3.75 15a8.25 8.25 0 0 0 14.61 3.36" />
      </svg>
    );
  }

  if (name === "rotate") {
    return (
      <svg className={common} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 7.5V3.75m0 3.75h-3.75m3.75 0A7.5 7.5 0 1 0 19.5 13.5" />
      </svg>
    );
  }

  if (name === "save") {
    return (
      <svg className={common} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 6.75A2.25 2.25 0 0 1 5.25 4.5h10.379c.597 0 1.169.237 1.591.659l1.621 1.621c.422.422.659.994.659 1.591v8.879A2.25 2.25 0 0 1 17.25 19.5H5.25A2.25 2.25 0 0 1 3 17.25V6.75Z" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 19.5v-5.25h9V19.5M7.5 4.5v4.125h7.5V4.5" />
      </svg>
    );
  }

  if (name === "search") {
    return (
      <svg className={common} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.197 5.197a7.5 7.5 0 0 0 10.606 10.606Z" />
      </svg>
    );
  }

  if (name === "shield") {
    return (
      <svg className={common} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 3.75 4.5 6.75v5.25c0 4.555 3.071 8.783 7.5 9.75 4.429-.967 7.5-5.195 7.5-9.75V6.75L12 3.75Z" />
      </svg>
    );
  }

  if (name === "unlock") {
    return (
      <svg className={common} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 10.5V6.75a3.75 3.75 0 0 1 7.5 0M6.75 10.5h9.75A2.25 2.25 0 0 1 18.75 12.75v5.25A2.25 2.25 0 0 1 16.5 20.25H6.75A2.25 2.25 0 0 1 4.5 18v-5.25A2.25 2.25 0 0 1 6.75 10.5Z" />
      </svg>
    );
  }

  return (
    <svg className={common} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
    </svg>
  );
}

export function AdminButton({
  children,
  icon,
  variant = "primary",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode;
  icon?: AdminIconName;
  variant?: ButtonVariant;
}) {
  const variantClass = {
    primary: "btn-primary",
    accent: "btn-accent",
    ghost: "btn-ghost",
    danger: "btn-danger",
    link: "admin-action-link",
    "danger-link": "admin-danger-link",
  }[variant];

  return (
    <button className={cx(variantClass, className)} {...props}>
      {icon ? <AdminIcon name={icon} /> : null}
      <span>{children}</span>
    </button>
  );
}

export function AdminLinkButton({
  children,
  href,
  icon,
  variant = "ghost",
  className,
}: {
  children: ReactNode;
  href: string;
  icon?: AdminIconName;
  variant?: Exclude<ButtonVariant, "danger-link" | "link">;
  className?: string;
}) {
  const variantClass = {
    primary: "btn-primary",
    accent: "btn-accent",
    ghost: "btn-ghost",
    danger: "btn-danger",
  }[variant];

  return (
    <Link href={href} className={cx(variantClass, className)}>
      {icon ? <AdminIcon name={icon} /> : null}
      <span>{children}</span>
    </Link>
  );
}

export function AdminField({
  children,
  label,
  className,
}: {
  children: ReactNode;
  label: string;
  className?: string;
}) {
  return (
    <div className={cx("admin-field", className)}>
      <label className="admin-label">{label}</label>
      {children}
    </div>
  );
}

export function AdminSelect({
  className,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { children: ReactNode }) {
  return (
    <select className={cx("admin-select", className)} {...props}>
      {children}
    </select>
  );
}

export function AdminCardHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <div className="admin-card-header">
      <div>
        <h2 className="admin-card-title">{title}</h2>
        {subtitle ? <p className="admin-card-subtitle">{subtitle}</p> : null}
      </div>
      {action}
    </div>
  );
}
