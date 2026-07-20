import { createListRoute } from "@/lib/resman-api";
import { workOrdersResource } from "@/lib/resman-resources";

export const GET = createListRoute(workOrdersResource);
