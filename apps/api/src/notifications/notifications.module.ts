import { Module } from "@nestjs/common";
import { MemberNotificationsController, MyDevicesController } from "./notifications.controller";

/** Messages to members (A14): queue, delivery over push / WhatsApp / SMS / email, devices and history. */
@Module({
  controllers: [MyDevicesController, MemberNotificationsController],
})
export class NotificationsModule {}
