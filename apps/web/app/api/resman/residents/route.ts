import { createListRoute } from "@/lib/resman-api";
import { residentsResource } from "@/lib/resman-resources";

export const GET = createListRoute(residentsResource);
