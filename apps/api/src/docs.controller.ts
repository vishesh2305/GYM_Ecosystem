import { Controller, Get } from "@nestjs/common";
import { Public } from "./auth/auth.guard";
import { buildApiDocs } from "./docs";

@Public()
@Controller()
export class DocsController {
  private readonly doc = buildApiDocs();

  @Get("docs.json")
  docs() {
    return this.doc;
  }
}
