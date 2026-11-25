import { Module } from "@nestjs/common";
import { AttendanceController } from "./attendance";
import { BookingsController, MyBookingsController } from "./bookings";
import { ClassesController, ClassSessionsController } from "./classes.controller";
import { PersonalTrainingController } from "./personal-training";

/** Class timetable, bookings, waitlists, attendance and personal training (A12). */
@Module({
  controllers: [
    ClassesController,
    ClassSessionsController,
    BookingsController,
    MyBookingsController,
    AttendanceController,
    PersonalTrainingController,
  ],
})
export class SchedulingModule {}
