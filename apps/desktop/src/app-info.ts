/**
 * The Electron product name: the packaged output's name, the `Name` entry of the
 * Linux desktop files, and the `app.setName()` value on Linux.
 */
import { TF_DESKTOP, TF_PRODUCT_NAME } from "./tf/flavour"; // tf:

export const PRODUCT_NAME = TF_DESKTOP ? TF_PRODUCT_NAME : "Trilium Notes"; // tf: Taskforce Notes builds
