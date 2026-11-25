import { Module } from "@nestjs/common";
import { ReportsController } from "./reports.controller";

/** Owner dashboard reports (A15): revenue, dues, attendance heatmap, retention cohorts. */
@Module({
  controllers: [ReportsController],
})
export class ReportsModule {}
