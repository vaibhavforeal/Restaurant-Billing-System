export function kitchenAddress(value: string): string {
  const input = value.trim();
  if (!input || /[\s\\]/.test(input)) throw new Error("Enter the main POS address, for example http://192.168.1.20:4100");
  const url = new URL(input.includes("://") ? input : `http://${input}`);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || !["/", "/kitchen", "/kitchen/"].includes(url.pathname)) throw new Error("Use the main POS http or https address without a username, query or extra path.");
  if (!input.includes("://") && !url.port) url.port = "4100";
  return `${url.origin}/kitchen/`;
}
