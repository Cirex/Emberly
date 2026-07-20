import { createDetailRoute } from "@/lib/resman-api";
import { leasesResource } from "@/lib/resman-resources";

export const GET = createDetailRoute(leasesResource);
