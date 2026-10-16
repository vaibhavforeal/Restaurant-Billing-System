export function accountActionFromUrl(href: string): { mode: "login" | "reset" | "invite"; token: string } {
  const url = new URL(href), params = new URLSearchParams(url.hash.slice(1));
  const invite = params.get("invite") ?? url.searchParams.get("invite");
  const reset = params.get("reset") ?? url.searchParams.get("reset");
  const token = invite ?? reset ?? url.searchParams.get("token") ?? "";
  const mode = invite || url.pathname.includes("invite") ? "invite" : reset || url.pathname.includes("reset") ? "reset" : "login";
  return { mode, token };
}
