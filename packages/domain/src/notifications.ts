import { addDays, todayIn, zonedTime } from "./dates";

export const LOCALES = ["en", "hi"] as const;
export type Locale = (typeof LOCALES)[number];

/** Delivery channels, in the default order tried: the cheapest that reaches the member first. */
export const CHANNELS = ["push", "whatsapp", "sms", "email"] as const;
export type Channel = (typeof CHANNELS)[number];

/**
 * service: about something the member did or is owed (payments, cancellations); cannot be muted.
 * reminders / engagement: the member may mute these.
 */
export const MUTABLE_CATEGORIES = ["reminders", "engagement"] as const;
export type MessageCategory = "service" | (typeof MUTABLE_CATEGORIES)[number];

interface TemplateDef {
  category: MessageCategory;
  /** Urgent messages ignore quiet hours. */
  urgent: boolean;
  /** Variables in the order WhatsApp and DLT SMS templates take them. */
  vars: readonly string[];
  text: Record<Locale, { title: string; body: string }>;
}

/**
 * Every automatic message. Placeholders are {var}. Variables are formatted by name: *Date ("2026-12-01") as a
 * date, *At (an ISO instant) as date and time in the gym's time zone, *Paise as rupees. The WhatsApp template
 * of each message is registered with Meta under "<key>" with these variables in order.
 */
export const MESSAGE_TEMPLATES = {
  renewal_due: {
    category: "reminders",
    urgent: false,
    vars: ["name", "gym", "plan", "endDate"],
    text: {
      en: {
        title: "Your membership ends soon",
        body: "Hi {name}, your {plan} membership at {gym} ends on {endDate}. Renew to keep training without a break.",
      },
      hi: {
        title: "आपकी सदस्यता जल्द समाप्त हो रही है",
        body: "नमस्ते {name}, {gym} में आपकी {plan} सदस्यता {endDate} को समाप्त हो रही है। बिना रुकावट ट्रेनिंग जारी रखने के लिए नवीनीकरण करें।",
      },
    },
  },
  payment_due: {
    category: "service",
    urgent: false,
    vars: ["name", "gym", "amountPaise", "dueDate"],
    text: {
      en: {
        title: "Payment due",
        body: "Hi {name}, {amountPaise} is due at {gym} (due date {dueDate}). You can pay in the app or at the desk.",
      },
      hi: {
        title: "भुगतान बाकी है",
        body: "नमस्ते {name}, {gym} में {amountPaise} का भुगतान बाकी है (अंतिम तिथि {dueDate})। आप ऐप में या काउंटर पर भुगतान कर सकते हैं।",
      },
    },
  },
  payment_failed: {
    category: "service",
    urgent: false,
    vars: ["name", "gym", "amountPaise"],
    text: {
      en: {
        title: "Payment did not go through",
        body: "Hi {name}, your payment of {amountPaise} to {gym} did not go through. Please try again in the app or pay at the desk.",
      },
      hi: {
        title: "भुगतान नहीं हो पाया",
        body: "नमस्ते {name}, {gym} को आपका {amountPaise} का भुगतान नहीं हो पाया। कृपया ऐप में फिर से कोशिश करें या काउंटर पर भुगतान करें।",
      },
    },
  },
  class_reminder: {
    category: "reminders",
    urgent: false,
    vars: ["name", "className", "startsAt"],
    text: {
      en: {
        title: "Class coming up",
        body: "Hi {name}, see you at {className} on {startsAt}. Can't make it? Cancel in the app to free your place.",
      },
      hi: {
        title: "आपकी क्लास जल्द है",
        body: "नमस्ते {name}, {startsAt} को {className} में मिलते हैं। नहीं आ पाएंगे? ऐप में रद्द करें ताकि किसी और को जगह मिल सके।",
      },
    },
  },
  waitlist_promoted: {
    category: "service",
    urgent: true,
    vars: ["name", "className", "startsAt"],
    text: {
      en: {
        title: "You got a place",
        body: "Good news {name}: a place opened up and you are now booked for {className} on {startsAt}.",
      },
      hi: {
        title: "आपको जगह मिल गई",
        body: "खुशखबरी {name}: एक जगह खाली हुई और अब {startsAt} को {className} में आपकी बुकिंग पक्की है।",
      },
    },
  },
  class_cancelled: {
    category: "service",
    urgent: true,
    vars: ["name", "className", "startsAt", "reason"],
    text: {
      en: {
        title: "Class cancelled",
        body: "Sorry {name}, {className} on {startsAt} has been cancelled: {reason}.",
      },
      hi: {
        title: "क्लास रद्द",
        body: "क्षमा करें {name}, {startsAt} की {className} रद्द कर दी गई है: {reason}।",
      },
    },
  },
  inactive: {
    category: "engagement",
    urgent: false,
    vars: ["name", "gym"],
    text: {
      en: {
        title: "We miss you",
        body: "Hi {name}, we haven't seen you at {gym} for a week. Even a short session keeps the habit going!",
      },
      hi: {
        title: "हम आपको याद कर रहे हैं",
        body: "नमस्ते {name}, आप एक हफ्ते से {gym} नहीं आए। छोटा सा सेशन भी आदत बनाए रखता है!",
      },
    },
  },
} as const satisfies Record<string, TemplateDef>;

export type MessageKey = keyof typeof MESSAGE_TEMPLATES;
export const MESSAGE_KEYS = Object.keys(MESSAGE_TEMPLATES) as MessageKey[];
export type MessageVars = Record<string, string | number>;

export interface RenderedMessage {
  title: string;
  body: string;
  /** Formatted variables in template order, for WhatsApp and DLT SMS templates. */
  params: string[];
}

const INTL_LOCALE: Record<Locale, string> = { en: "en-IN", hi: "hi-IN" };

function formatVar(name: string, value: string | number, locale: Locale, timeZone: string): string {
  const intl = INTL_LOCALE[locale];
  if (name.endsWith("Paise"))
    return new Intl.NumberFormat(intl, { style: "currency", currency: "INR" }).format(
      Number(value) / 100,
    );
  if (name.endsWith("Date"))
    return new Intl.DateTimeFormat(intl, { dateStyle: "medium", timeZone: "UTC" }).format(
      new Date(`${String(value)}T00:00:00Z`),
    );
  if (name.endsWith("At"))
    return new Intl.DateTimeFormat(intl, {
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "numeric",
      minute: "2-digit",
      timeZone,
    }).format(new Date(String(value)));
  return String(value);
}

/** The message in the member's language, with variables formatted for them and the gym's time zone. */
export function renderMessage(
  key: MessageKey,
  locale: Locale,
  vars: MessageVars,
  timeZone: string,
): RenderedMessage {
  const template: TemplateDef = MESSAGE_TEMPLATES[key];
  const formatted = Object.fromEntries(
    template.vars.map((name) => {
      const value = vars[name];
      if (value === undefined) throw new Error(`${key}: missing variable ${name}`);
      return [name, formatVar(name, value, locale, timeZone)];
    }),
  );
  const fill = (s: string) => s.replace(/\{(\w+)\}/g, (_, name: string) => formatted[name] ?? "");
  const text = template.text[locale];
  return {
    title: fill(text.title),
    body: fill(text.body),
    params: template.vars.map((name) => formatted[name] ?? ""),
  };
}

export interface QuietHours {
  /** "HH:MM" in the gym's time zone. Equal start and end means no quiet hours. */
  start: string;
  end: string;
}

/** By default nothing that can wait is sent between 9 pm and 8 am. */
export const DEFAULT_QUIET_HOURS: QuietHours = { start: "21:00", end: "08:00" };

const localTime = (now: Date, timeZone: string) =>
  new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone,
  }).format(now);

/** When the quiet hours `now` falls in end, or null when `now` is outside them. Windows may cross midnight. */
export function quietUntil(now: Date, timeZone: string, quiet: QuietHours): Date | null {
  const { start, end } = quiet;
  if (start === end) return null;
  const time = localTime(now, timeZone);
  const today = todayIn(timeZone, now);
  if (start < end) return time >= start && time < end ? zonedTime(today, end, timeZone) : null;
  if (time >= start) return zonedTime(addDays(today, 1), end, timeZone);
  if (time < end) return zonedTime(today, end, timeZone);
  return null;
}
