import { createDetailRoute } from "@/lib/resman-api";
import { mlgwBillsResource } from "@/lib/resman-resources";

export const GET = createDetailRoute(mlgwBillsResource);
