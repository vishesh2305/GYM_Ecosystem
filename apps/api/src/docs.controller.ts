import { Controller, Get } from "@nestjs/common";
import { buildApiDocs } from "./docs";

@Controller()
export class DocsController {
  private readonly doc = buildApiDocs();

  @Get("docs.json")
  docs() {
    return this.doc;
  }
}
