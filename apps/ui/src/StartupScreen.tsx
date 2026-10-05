import { startupMarkup, startupStyles } from "./startup-screen";

const openingMarkup = { __html: startupMarkup() };

export function StartupScreen() {
  return <><style>{startupStyles}</style><div dangerouslySetInnerHTML={openingMarkup} /></>;
}
