import type { CreateBudget, CreateRule, UpdateBudget, UpdateRule } from "@auxo/shared";
import type { SettingsRepository } from "../repositories/settings-repository.js";

export class SettingNotFoundError extends Error {}

export class SettingsService {
  public constructor(private readonly repository: SettingsRepository) {}
  public listRules(userId: string) { return this.repository.listRules(userId); }
  public createRule(userId: string, input: CreateRule) { return this.repository.createRule(userId, input); }
  public async updateRule(userId: string, id: string, input: UpdateRule) {
    const value = await this.repository.updateRule(userId, id, input);
    if (!value) throw new SettingNotFoundError();
    return value;
  }
  public async deleteRule(userId: string, id: string) {
    if (!(await this.repository.deleteRule(userId, id))) throw new SettingNotFoundError();
  }
  public listBudgets(userId: string) { return this.repository.listBudgets(userId); }
  public createBudget(userId: string, input: CreateBudget) { return this.repository.createBudget(userId, input); }
  public async updateBudget(userId: string, id: string, input: UpdateBudget) {
    const value = await this.repository.updateBudget(userId, id, input);
    if (!value) throw new SettingNotFoundError();
    return value;
  }
  public async deleteBudget(userId: string, id: string) {
    if (!(await this.repository.deleteBudget(userId, id))) throw new SettingNotFoundError();
  }
}
