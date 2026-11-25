import { Module } from "@nestjs/common";
import { MyGymsController } from "./my-gyms";
import { MyPassController } from "./passes";

/** Members' app access and gym entry: linked accounts, gym passes, kiosks, check-ins and occupancy (A11). */
@Module({ controllers: [MyGymsController, MyPassController] })
export class AccessModule {}
