import { createListRoute } from "@/lib/resman-api";
import { mlgwPaymentsResource } from "@/lib/resman-resources";

export const GET = createListRoute(mlgwPaymentsResource);
