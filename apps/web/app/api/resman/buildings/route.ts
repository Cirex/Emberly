import { createListRoute } from "@/lib/resman-api";
import { buildingsResource } from "@/lib/resman-resources";

export const GET = createListRoute(buildingsResource);
