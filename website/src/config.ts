// One place for the facts the owner may change before launch.
export const config = {
  name: 'MasalaPOS',
  // WhatsApp number, digits only with country code (owner, 2026-11-06).
  whatsapp: '918073417810',
  whatsappDisplay: '+91 80734 17810',
  // Contact email is undecided. Leave null and the site simply shows no email.
  email: null as string | null,
  // The owner states there will be no per-captain or per-device fee, but the licensing
  // change has NOT shipped (the app today is Basic 2 / Pro 5 devices).
  // Keep this false until it ships; the site then states the real device counts.
  unlimitedDevices: false,
};

export const waLink = (text: string) =>
  `https://wa.me/${config.whatsapp}?text=${encodeURIComponent(text)}`;
