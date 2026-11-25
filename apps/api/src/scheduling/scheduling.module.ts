import { Module } from "@nestjs/common";
import { AttendanceController } from "./attendance";
import { BookingsController, MyBookingsController } from "./bookings";
import { ClassesController, ClassSessionsController } from "./classes.controller";

/** Class timetable, bookings, waitlists, attendance and personal training (A12). */
@Module({
  controllers: [
    ClassesController,
    ClassSessionsController,
    BookingsController,
    MyBookingsController,
    AttendanceController,
  ],
})
export class SchedulingModule {}
