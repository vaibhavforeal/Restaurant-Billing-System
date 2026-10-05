import type { ReactNode } from "react";
import { Brand } from "../Icon";
import { ThemeToggle } from "../ThemeToggle";

export function AuthLayout({ children }: { children: ReactNode }) {
  return <div className="auth-shell"><main className="auth-card"><div className="auth-brand-row"><Brand /><ThemeToggle /></div>{children}</main></div>;
}
