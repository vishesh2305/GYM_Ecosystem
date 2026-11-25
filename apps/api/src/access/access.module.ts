import { Module } from "@nestjs/common";
import { MyGymsController } from "./my-gyms";

/** Members' app access and gym entry: linked accounts, gym passes, kiosks, check-ins and occupancy (A11). */
@Module({ controllers: [MyGymsController] })
export class AccessModule {}
