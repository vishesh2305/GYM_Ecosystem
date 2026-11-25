import { Module } from "@nestjs/common";
import { LeadsController } from "./leads.controller";

/** Sales (A15): leads, the pipeline, follow-up tasks and trials. */
@Module({
  controllers: [LeadsController],
})
export class CrmModule {}
