import { Module } from "@nestjs/common";
import { ClassesController, ClassSessionsController } from "./classes.controller";

/** Class timetable, bookings, waitlists, attendance and personal training (A12). */
@Module({ controllers: [ClassesController, ClassSessionsController] })
export class SchedulingModule {}
