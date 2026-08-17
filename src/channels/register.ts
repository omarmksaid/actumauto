// Registers the message senders into the channel registry. Imported for side effects.
import { registerSender } from "./types";
import { smsSender } from "./sms";
import { emailSender } from "./email";

registerSender(smsSender);
registerSender(emailSender);
