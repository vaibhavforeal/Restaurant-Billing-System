import type { ReactNode } from "react";
import { Brand } from "../Icon";

export function AuthLayout({ children }: { children: ReactNode }) {
  return <div className="auth-shell"><main className="auth-card"><Brand />{children}</main></div>;
}
