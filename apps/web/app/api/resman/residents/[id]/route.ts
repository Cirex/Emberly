import { createDetailRoute } from "@/lib/resman-api";
import { residentsResource } from "@/lib/resman-resources";

export const GET = createDetailRoute(residentsResource);
