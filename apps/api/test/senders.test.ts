import { describe, expect, it } from "vitest";
import { ConsoleEmailSender, ConsoleSmsSender } from "../src/auth/senders";

describe("development senders", () => {
  it("keep only the last 100 messages", async () => {
    const sms = new ConsoleSmsSender();
    const mail = new ConsoleEmailSender();
    for (let i = 0; i < 105; i++) {
      await sms.send("+910000000000", `message ${i}`);
      await mail.send({ to: "a@b.co", subject: `s${i}`, text: "t" });
    }
    expect(sms.sent).toHaveLength(100);
    expect(sms.sent[0]?.text).toBe("message 5");
    expect(mail.sent).toHaveLength(100);
  });
});
