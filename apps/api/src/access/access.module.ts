import { Module } from "@nestjs/common";
import { MembershipModule } from "../membership/membership.module";
import { DeskCheckInsController, KioskCheckInsController, MyVisitsController } from "./check-ins";
import { KioskDeviceController, KiosksController } from "./kiosks";
import { MyGymsController } from "./my-gyms";
import { MyGymOccupancyController, OccupancyController } from "./occupancy";
import { MyPassController } from "./passes";

/** Members' app access and gym entry: linked accounts, gym passes, kiosks, check-ins and occupancy (A11). */
@Module({
  imports: [MembershipModule],
  controllers: [
    MyGymsController,
    MyPassController,
    KiosksController,
    KioskDeviceController,
    KioskCheckInsController,
    DeskCheckInsController,
    MyVisitsController,
    OccupancyController,
    MyGymOccupancyController,
  ],
})
export class AccessModule {}
