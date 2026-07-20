import { createListRoute } from "@/lib/resman-api";
import { leasesResource } from "@/lib/resman-resources";

export const GET = createListRoute(leasesResource);
