import { Hono } from "hono";
import { authMiddleware } from "../../middleware/auth.middleware.js";
import { unitController } from "./unit.controller.js";
import { createUnitSchema, updateUnitSchema } from "./unit.schema.js";

const router = new Hono();

const validateBody = (schema: any) => {
  return async (c: any, next: any) => {
    const body = await c.req.json();
    const result = schema.safeParse(body);
    if (!result.success) {
      return c.json({ success: false, error: result.error.issues[0].message }, 400);
    }
    c.set("validatedBody", result.data);
    await next();
  };
};

router.use("*", authMiddleware);

router.get("/", unitController.getAll);
router.post("/", validateBody(createUnitSchema), unitController.create);
router.put("/:id", validateBody(updateUnitSchema), unitController.update);
router.delete("/:id", unitController.delete);

export default router;
