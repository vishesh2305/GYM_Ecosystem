import { Module } from "@nestjs/common";
import { LeadsController } from "./leads.controller";
import { PublicGymsController } from "./public-gyms.controller";

/** Sales (A15): leads, the pipeline, follow-up tasks, trials, and the public gym page with its enquiry form. */
@Module({
  controllers: [LeadsController, PublicGymsController],
})
export class CrmModule {}
