import { Module } from "@nestjs/common";
import { BookingsController, MyBookingsController } from "./bookings";
import { ClassesController, ClassSessionsController } from "./classes.controller";

/** Class timetable, bookings, waitlists, attendance and personal training (A12). */
@Module({
  controllers: [
    ClassesController,
    ClassSessionsController,
    BookingsController,
    MyBookingsController,
  ],
})
export class SchedulingModule {}
