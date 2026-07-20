import { createDetailRoute } from "@/lib/resman-api";
import { unitsResource } from "@/lib/resman-resources";

export const GET = createDetailRoute(unitsResource);
