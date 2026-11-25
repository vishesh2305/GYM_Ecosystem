import { describe, expect, it } from "vitest";
import {
  LOCALES,
  MESSAGE_KEYS,
  MESSAGE_TEMPLATES,
  quietUntil,
  renderMessage,
  type MessageVars,
} from "./notifications";

const IST = "Asia/Kolkata";

describe("renderMessage", () => {
  it("fills and formats variables for the member's language and the gym's time zone", () => {
    const vars = { name: "Asha", className: "Yoga", startsAt: "2026-12-01T01:30:00.000Z" };
    const en = renderMessage("class_reminder", "en", vars, IST);
    expect(en.title).toBe("Class coming up");
    expect(en.body).toContain("Hi Asha, see you at Yoga on Tue, 1 Dec, 7:00");
    expect(en.params[0]).toBe("Asha");
    expect(en.params[2]).toMatch(/^Tue, 1 Dec, 7:00/);

    const hi = renderMessage("class_reminder", "hi", vars, IST);
    expect(hi.body).toContain("नमस्ते Asha");
    expect(hi.body).toContain("Yoga");
  });

  it("shows amounts in rupees and dates as dates", () => {
    const { body } = renderMessage(
      "payment_due",
      "en",
      { name: "Ravi", gym: "Iron Den", amountPaise: 150000, dueDate: "2026-12-05" },
      IST,
    );
    expect(body).toBe(
      "Hi Ravi, ₹1,500.00 is due at Iron Den (due date 5 Dec 2026). You can pay in the app or at the desk.",
    );
  });

  it("refuses to send a message with a missing variable", () => {
    expect(() => renderMessage("inactive", "en", { name: "Asha" }, IST)).toThrow(
      /missing variable gym/,
    );
  });

  it("has every message in every language, using only the variables it declares", () => {
    for (const key of MESSAGE_KEYS) {
      const template = MESSAGE_TEMPLATES[key];
      const vars: MessageVars = Object.fromEntries(
        template.vars.map((v) => [
          v,
          v.endsWith("Date")
            ? "2026-12-01"
            : v.endsWith("At")
              ? "2026-12-01T00:00:00Z"
              : v.endsWith("Paise")
                ? 100
                : v,
        ]),
      );
      for (const locale of LOCALES) {
        const text = template.text[locale];
        const used = [...`${text.title} ${text.body}`.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
        for (const name of used) expect(template.vars, `${key}/${locale}`).toContain(name);
        const out = renderMessage(key, locale, vars, IST);
        expect(out.body).not.toMatch(/[{}]/);
      }
    }
  });
});

describe("quietUntil", () => {
  const quiet = { start: "21:00", end: "08:00" };
  const ist = (local: string) => new Date(`${local}+05:30`);

  it("defers messages in a quiet window that crosses midnight to its end", () => {
    expect(quietUntil(ist("2026-12-01T22:30"), IST, quiet)).toEqual(ist("2026-12-02T08:00"));
    expect(quietUntil(ist("2026-12-02T06:15"), IST, quiet)).toEqual(ist("2026-12-02T08:00"));
    expect(quietUntil(ist("2026-12-01T21:00"), IST, quiet)).toEqual(ist("2026-12-02T08:00"));
  });

  it("lets messages through outside quiet hours", () => {
    expect(quietUntil(ist("2026-12-01T08:00"), IST, quiet)).toBeNull();
    expect(quietUntil(ist("2026-12-01T20:59"), IST, quiet)).toBeNull();
  });

  it("handles a window within one day and no quiet hours at all", () => {
    const afternoon = { start: "13:00", end: "15:00" };
    expect(quietUntil(ist("2026-12-01T14:00"), IST, afternoon)).toEqual(ist("2026-12-01T15:00"));
    expect(quietUntil(ist("2026-12-01T16:00"), IST, afternoon)).toBeNull();
    expect(quietUntil(ist("2026-12-01T23:00"), IST, { start: "00:00", end: "00:00" })).toBeNull();
  });
});
