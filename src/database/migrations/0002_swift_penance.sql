ALTER TABLE "subscription_plans" ADD COLUMN "max_shops" integer;--> statement-breakpoint
ALTER TABLE "subscription_plans" ADD COLUMN "max_sellers" integer;--> statement-breakpoint
CREATE INDEX "debtors_sale_id_idx" ON "debtors" USING btree ("sale_id");--> statement-breakpoint
CREATE INDEX "products_category_id_idx" ON "products" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "products_active_idx" ON "products" USING btree ("is_active") WHERE "products"."is_active" = true;--> statement-breakpoint
CREATE INDEX "sale_items_cargo_entry_id_idx" ON "sale_items" USING btree ("cargo_entry_id");--> statement-breakpoint
CREATE INDEX "sale_items_sale_product_idx" ON "sale_items" USING btree ("sale_id","product_id");--> statement-breakpoint
CREATE INDEX "sales_shop_created_at_idx" ON "sales" USING btree ("shop_id","created_at");--> statement-breakpoint
CREATE INDEX "shops_tenant_active_idx" ON "shops" USING btree ("tenant_id","is_active");--> statement-breakpoint
CREATE INDEX "subpay_subscription_id_idx" ON "subscription_payments" USING btree ("subscription_id");--> statement-breakpoint
CREATE INDEX "sub_tenant_status_period_idx" ON "tenant_subscriptions" USING btree ("tenant_id","status","current_period_end");--> statement-breakpoint
CREATE INDEX "sub_plan_id_idx" ON "tenant_subscriptions" USING btree ("plan_id");