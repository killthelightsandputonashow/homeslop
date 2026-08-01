import { onRequestGet as importAO3 } from "./functions/api/import.js";

export default {
  async fetch(request, env, context) {
    const url = new URL(request.url);

    if (url.pathname === "/api/import") {
      return importAO3({
        request,
        env,
        params: {},
        data: {},
        next: () => env.ASSETS.fetch(request),
        waitUntil: context.waitUntil.bind(context),
      });
    }

    return env.ASSETS.fetch(request);
  },
};
