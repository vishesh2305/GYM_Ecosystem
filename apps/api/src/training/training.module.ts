import { Module } from "@nestjs/common";
import { ExercisesController } from "./exercises";
import { SyncController } from "./sync";
import { MyWorkoutsController } from "./workouts";

/** Personal training data (A13): the exercise library, workouts, personal records and body metrics. */
@Module({
  controllers: [ExercisesController, SyncController, MyWorkoutsController],
})
export class TrainingModule {}
