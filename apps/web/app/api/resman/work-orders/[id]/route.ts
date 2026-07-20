import { createDetailRoute } from "@/lib/resman-api";
import { workOrdersResource } from "@/lib/resman-resources";

export const GET = createDetailRoute(workOrdersResource);
