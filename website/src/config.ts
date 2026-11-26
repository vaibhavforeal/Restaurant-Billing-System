// One place for the facts the owner may change before launch.
export const config = {
  name: 'MasalaPOS',
  // WhatsApp number, digits only with country code (owner, 2026-11-06).
  whatsapp: '918073417810',
  whatsappDisplay: '+91 80734 17810',
  // Contact email is undecided. Leave null and the site simply shows no email.
  email: 'lead@masalapos.com' as string | null,
  // The owner states there will be no per-captain or per-device fee, but the licensing
  // change has NOT shipped (the app today is Basic 2 / Pro 5 devices).
  // Owner approved showing this on 2026-11-06. Set false to state the real device counts (Basic 2, Pro 5).
  unlimitedDevices: true,
};

export const waLink = (text: string) =>
  `https://wa.me/${config.whatsapp}?text=${encodeURIComponent(text)}`;
