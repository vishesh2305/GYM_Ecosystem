import { Module } from "@nestjs/common";
import { ExercisesController } from "./exercises";

/** Personal training data (A13): the exercise library, workouts, personal records and body metrics. */
@Module({
  controllers: [ExercisesController],
})
export class TrainingModule {}
