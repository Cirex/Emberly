import { createDetailRoute } from "@/lib/resman-api";
import { buildingsResource } from "@/lib/resman-resources";

export const GET = createDetailRoute(buildingsResource);
