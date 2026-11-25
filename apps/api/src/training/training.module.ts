import { Module } from "@nestjs/common";
import { ExercisesController } from "./exercises";
import { MyRecordsController } from "./records";
import { SyncController } from "./sync";
import { MyWorkoutsController } from "./workouts";

/** Personal training data (A13): the exercise library, workouts, personal records and body metrics. */
@Module({
  controllers: [ExercisesController, SyncController, MyWorkoutsController, MyRecordsController],
})
export class TrainingModule {}
