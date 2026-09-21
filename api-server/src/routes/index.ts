import { Router, type IRouter } from "express";
import authRouter from "./auth";
import healthRouter from "./health";
import iddetAdsRouter from "./iddet-ads";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(iddetAdsRouter);

export default router;
