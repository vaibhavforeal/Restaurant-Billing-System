import { describe, expect, it } from "vitest";
import { formatRestaurantAddress, normalisePhone, profileErrors, stateFromGstin } from "./restaurant-profile.js";
import { RestaurantProfile } from "./restaurant-profile-schema.js";

const VALID = {
  restaurantName: "Spice Route", address: "12, 100 Feet Road, Indiranagar", city: "Bengaluru", stateCode: "29",
  pincode: "560038", phone: "98450 12345", gstin: "", fssai: "",
};

describe("normalisePhone", () => {
  it("keeps the ten digits of a mobile or landline number", () => {
    expect(normalisePhone("+91 98450-12345")).toBe("9845012345");
    expect(normalisePhone("919845012345")).toBe("9845012345");
    expect(normalisePhone("098450 12345")).toBe("9845012345");
    expect(normalisePhone("(080) 4123 4567")).toBe("8041234567");
  });
});

describe("RestaurantProfile", () => {
  it("accepts a complete profile and cleans the phone", () => {
    const parsed = RestaurantProfile.parse(VALID);
    expect(parsed.phone).toBe("9845012345");
    expect(parsed.gstin).toBe("");
  });

  it("requires the address, city, state, PIN code and phone", () => {
    for (const key of ["address", "city", "stateCode", "pincode", "phone"] as const) {
      const result = RestaurantProfile.safeParse({ ...VALID, [key]: "" });
      expect(result.success, key).toBe(false);
      expect(result.error!.issues[0]!.path).toEqual([key]);
    }
  });

  it("rejects malformed PIN codes, phones and unknown states", () => {
    expect(RestaurantProfile.safeParse({ ...VALID, pincode: "056003" }).success).toBe(false);
    expect(RestaurantProfile.safeParse({ ...VALID, pincode: "56003" }).success).toBe(false);
    expect(RestaurantProfile.safeParse({ ...VALID, phone: "12345" }).success).toBe(false);
    expect(RestaurantProfile.safeParse({ ...VALID, stateCode: "99" }).success).toBe(false);
  });

  it("uppercases a valid GSTIN and checks it belongs to the chosen state", () => {
    expect(RestaurantProfile.parse({ ...VALID, gstin: "29abcde1234f1z5" }).gstin).toBe("29ABCDE1234F1Z5");
    const wrongState = RestaurantProfile.safeParse({ ...VALID, gstin: "27ABCDE1234F1Z5" });
    expect(wrongState.success).toBe(false);
    expect(wrongState.error!.issues[0]!.path).toEqual(["gstin"]);
    expect(RestaurantProfile.safeParse({ ...VALID, gstin: "29ABCDE1234" }).success).toBe(false);
  });

  it("accepts a 14-digit FSSAI number or none", () => {
    expect(RestaurantProfile.safeParse({ ...VALID, fssai: "12345678901234" }).success).toBe(true);
    expect(RestaurantProfile.safeParse({ ...VALID, fssai: "1234" }).success).toBe(false);
    expect(RestaurantProfile.parse({ ...VALID, gstin: undefined, fssai: undefined }).fssai).toBe("");
  });
});

describe("profileErrors", () => {
  it("is empty for a valid draft and names each bad field, as the server would", () => {
    expect(profileErrors(VALID)).toEqual({});
    const errors = profileErrors({ ...VALID, city: " ", pincode: "1234", phone: "99" });
    expect(Object.keys(errors).sort()).toEqual(["city", "phone", "pincode"]);
    expect(errors.city).toBe("Enter the city");
  });
  it("flags a GSTIN from another state on the GSTIN field, even typed in lower case", () => {
    expect(profileErrors({ ...VALID, gstin: "27abcde1234f1z5" }).gstin).toMatch(/different state/);
    expect(profileErrors({ ...VALID, gstin: "29abcde1234f1z5" })).toEqual({});
  });
});

describe("stateFromGstin", () => {
  it("reads the state code from a well-formed GSTIN only", () => {
    expect(stateFromGstin("29ABCDE1234F1Z5")).toBe("29");
    expect(stateFromGstin("29ABC")).toBeNull();
    expect(stateFromGstin("99ABCDE1234F1Z5")).toBeNull();
  });
});

describe("formatRestaurantAddress", () => {
  it("joins street, city, state and PIN code", () => {
    expect(formatRestaurantAddress(VALID)).toBe("12, 100 Feet Road, Indiranagar, Bengaluru, Karnataka - 560038");
  });
  it("leaves out the parts that are empty", () => {
    expect(formatRestaurantAddress({ address: "MG Road", city: "", stateCode: "", pincode: "" })).toBe("MG Road");
    expect(formatRestaurantAddress({ address: "MG Road", city: "Pune", stateCode: "", pincode: "411001" })).toBe("MG Road, Pune - 411001");
  });
});
