/*
 * Wire
 * Copyright (C) 2018 Wire Swiss GmbH
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see http://www.gnu.org/licenses/.
 *
 */

import {
  AccessUpdate,
  CodeUpdate,
  ConnectRequest,
  Conversation,
  ConversationMessageTimerUpdate,
  MemberJoin,
  MemberLeave,
  MemberUpdate,
  OtrMessageAdd,
  Rename,
  Typing,
} from '../conversation/';
import {ConversationConnectRequestData, ConversationMemberLeaveData} from '../conversation/data';
import {BackendEvent} from './BackendEvent';

export enum CONVERSATION_EVENT {
  ACCESS_UPDATE = 'conversation.access-update',
  CODE_DELETE = 'conversation.code-delete',
  CODE_UPDATE = 'conversation.code-update',
  CONNECT_REQUEST = 'conversation.connect-request',
  CREATE = 'conversation.create',
  DELETE = 'conversation.delete',
  MEMBER_JOIN = 'conversation.member-join',
  MEMBER_LEAVE = 'conversation.member-leave',
  MEMBER_UPDATE = 'conversation.member-update',
  MESSAGE_TIMER_UPDATE = 'conversation.message-timer-update',
  OTR_MESSAGE_ADD = 'conversation.otr-message-add',
  RENAME = 'conversation.rename',
  TYPING = 'conversation.typing',
}

export enum CONVERSATION_TYPING {
  STARTED = 'started',
  STOPPED = 'stopped',
}

export interface ConversationEvent extends BackendEvent {
  conversation: string;
  data: {};
  from: string;
  time: string;
  type: CONVERSATION_EVENT;
}

export interface ConversationAccessUpdateEvent extends ConversationEvent {
  data: AccessUpdate;
  type: CONVERSATION_EVENT.ACCESS_UPDATE;
}

export interface ConversationCodeDeleteEvent extends ConversationEvent {
  type: CONVERSATION_EVENT.CODE_DELETE;
}

export interface ConversationCodeUpdateEvent extends ConversationEvent {
  data: CodeUpdate;
  type: CONVERSATION_EVENT.CODE_UPDATE;
}

export interface ConversationConnectRequestEvent extends ConversationEvent {
  data: ConnectRequest;
  type: CONVERSATION_EVENT.CONNECT_REQUEST;
}

export interface ConversationConnectRequestNotification {
  conversation: string;
  data: ConversationConnectRequestData;
  from: string;
  time: string;
  type: CONVERSATION_EVENT.CONNECT_REQUEST;
}

export interface ConversationCreateEvent extends ConversationEvent {
  data: Conversation;
  type: CONVERSATION_EVENT.CREATE;
}

export interface ConversationCreateNotification {
  conversation: string;
  data: Conversation & {
    /** @deprecated */
    last_event: string;
    /** @deprecated */
    last_event_time: string;
    receipt_mode: null;
  };
  from: string;
  time: string;
  type: CONVERSATION_EVENT.CREATE;
}

export interface ConversationDeleteEvent extends ConversationEvent {
  type: CONVERSATION_EVENT.DELETE;
}

export interface ConversationDeleteNotification {
  conversation: string;
  data: null;
  from: string;
  time: string;
  type: CONVERSATION_EVENT.DELETE;
}

export interface ConversationMemberJoinEvent extends ConversationEvent {
  data: MemberJoin;
  type: CONVERSATION_EVENT.MEMBER_JOIN;
}

export interface ConversationMemberJoinNotification {
  conversation: string;
  data: {
    user_ids: string[];
  };
  from: string;
  time: string;
  type: CONVERSATION_EVENT.MEMBER_JOIN;
}

export interface ConversationMemberLeaveEvent extends ConversationEvent {
  data: MemberLeave;
  type: CONVERSATION_EVENT.MEMBER_LEAVE;
}

export interface ConversationMemberLeaveNotification {
  conversation: string;
  from: string;
  time: string;
  data: ConversationMemberLeaveData;
  type: CONVERSATION_EVENT.MEMBER_LEAVE;
}

export interface ConversationMemberUpdateEvent extends ConversationEvent {
  data: MemberUpdate;
  type: CONVERSATION_EVENT.MEMBER_UPDATE;
}

export interface ConversationMessageTimerUpdateEvent extends ConversationEvent {
  data: ConversationMessageTimerUpdate;
  type: CONVERSATION_EVENT.MESSAGE_TIMER_UPDATE;
}

export interface ConversationOtrMessageAddEvent extends ConversationEvent {
  data: OtrMessageAdd;
  type: CONVERSATION_EVENT.OTR_MESSAGE_ADD;
}

export interface ConversationOtrMessageAddNotification {
  conversation: string;
  data: OtrMessageAdd;
  from: string;
  time: string;
  type: CONVERSATION_EVENT.OTR_MESSAGE_ADD;
}

export interface ConversationRenameEvent extends ConversationEvent {
  data: Rename;
  type: CONVERSATION_EVENT.RENAME;
}

export interface ConversationTypingEvent extends ConversationEvent {
  data: Typing;
  type: CONVERSATION_EVENT.TYPING;
}

export interface ConversationTypingNotification {
  conversation: string;
  data: Typing;
  from: string;
  time: string;
  type: CONVERSATION_EVENT.TYPING;
}
