/** Command-template barrel (M4-5). */
export {
  ALLOWED_CUSTOM_OPTIONS, DENIED_CUSTOM_OPTIONS,
  validateTemplateArgs, customCommandRejected,
  type TemplateValidation,
} from './validate.js';
export {
  CommandTemplateStore,
  type CommandTemplate, type CommandTemplateInput, type CommandTemplateStoreDeps,
} from './store.js';
