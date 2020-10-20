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

import {APIClient} from '@wireapp/api-client';
import {
  Conversation,
  CONVERSATION_TYPE,
  DefaultConversationRoleName,
  MutedStatus,
  NewConversation,
  NewOTRMessage,
  OTRRecipients,
  UserClients,
} from '@wireapp/api-client/src/conversation/';
import {CONVERSATION_TYPING, ConversationMemberUpdateData} from '@wireapp/api-client/src/conversation/data/';
import {ConversationMemberLeaveEvent} from '@wireapp/api-client/src/event/';
import {StatusCode} from '@wireapp/api-client/src/http/';
import {UserPreKeyBundleMap} from '@wireapp/api-client/src/user/';
import {
  Asset,
  ButtonAction,
  ButtonActionConfirmation,
  Calling,
  Cleared,
  ClientAction,
  Composite,
  Confirmation,
  Ephemeral,
  GenericMessage,
  Knock,
  Location,
  MessageDelete,
  MessageEdit,
  MessageHide,
  Reaction,
} from '@wireapp/protocol-messaging';
import {AxiosError} from 'axios';
import {Encoder} from 'bazinga64';
import {
  AssetService,
  AssetTransferState,
  GenericMessageType,
  MessageTimer,
  PayloadBundleSource,
  PayloadBundleState,
  PayloadBundleType,
} from '../conversation/';

import {AssetContent, ClearedContent, DeletedContent, HiddenContent, RemoteData} from '../conversation/content/';

import {CryptographyService, EncryptedAsset} from '../cryptography/';
import * as AssetCryptography from '../cryptography/AssetCryptography.node';
import {MessageBuilder} from './message/MessageBuilder';
import {MessageToProtoMapper} from './message/MessageToProtoMapper';
import {
  ButtonActionConfirmationMessage,
  ButtonActionMessage,
  CallMessage,
  ClearConversationMessage,
  CompositeMessage,
  ConfirmationMessage,
  DeleteMessage,
  EditedTextMessage,
  FileAssetAbortMessage,
  FileAssetMessage,
  FileAssetMetaDataMessage,
  HideMessage,
  ImageAssetMessage,
  ImageAssetMessageOutgoing,
  LocationMessage,
  OtrMessage,
  PingMessage,
  ReactionMessage,
  ResetSessionMessage,
  TextMessage,
} from './message/OtrMessage';

/** A map of the format `{ UserId: [clientId, ...] }` */
export type UserClientsMap = Record<string, string[]>;

export class ConversationService {
  public readonly messageTimer: MessageTimer;
  public readonly messageBuilder: MessageBuilder;

  constructor(
    private readonly apiClient: APIClient,
    private readonly cryptographyService: CryptographyService,
    private readonly assetService: AssetService,
  ) {
    this.messageTimer = new MessageTimer();
    this.messageBuilder = new MessageBuilder(this.apiClient, this.assetService);
  }

  private createEphemeral(originalGenericMessage: GenericMessage, expireAfterMillis: number): GenericMessage {
    const ephemeralMessage = Ephemeral.create({
      expireAfterMillis,
      [originalGenericMessage.content!]: originalGenericMessage[originalGenericMessage.content!],
    });

    const genericMessage = GenericMessage.create({
      [GenericMessageType.EPHEMERAL]: ephemeralMessage,
      messageId: originalGenericMessage.messageId,
    });

    return genericMessage;
  }

  private async getPreKeyBundle(
    conversationId: string,
    userIds?: string[] | UserClientsMap,
  ): Promise<UserPreKeyBundleMap> {
    const conversation = await this.apiClient.conversation.api.getConversation(conversationId);

    let members: string[];

    if (userIds && Array.isArray(userIds) && userIds.length) {
      members = userIds;
    } else if (userIds) {
      members = Object.keys(userIds);
    } else {
      /*
       * If you are sending a message to a conversation, you have to include
       * yourself in the list of users if you want to sync a message also to your
       * other clients.
       */
      members = conversation.members.others.map(member => member.id).concat(conversation.members.self.id);
    }

    let preKeys = await Promise.all(members.map(member => this.apiClient.user.api.getUserPreKeys(member)));

    if (userIds && !Array.isArray(userIds)) {
      preKeys = preKeys.map(preKey => {
        if (preKey.user in userIds) {
          preKey.clients = preKey.clients.filter(client => userIds[preKey.user].includes(client.client));
        }
        return preKey;
      });
    }

    return preKeys.reduce((bundleMap: UserPreKeyBundleMap, bundle) => {
      bundleMap[bundle.user] = {};
      for (const client of bundle.clients) {
        bundleMap[bundle.user][client.client] = client.prekey;
      }
      return bundleMap;
    }, {});
  }

  private getSelfConversation(): Promise<Conversation> {
    const {userId} = this.apiClient.context!;
    return this.apiClient.conversation.api.getConversation(userId);
  }

  private async sendExternalGenericMessage(
    sendingClientId: string,
    conversationId: string,
    asset: EncryptedAsset,
    preKeyBundles: UserPreKeyBundleMap,
  ): Promise<void> {
    const {cipherText, keyBytes, sha256} = asset;
    const messageId = MessageBuilder.createId();

    const externalMessage = {
      otrKey: new Uint8Array(keyBytes),
      sha256: new Uint8Array(sha256),
    };

    const base64CipherText = Encoder.toBase64(cipherText).asString;

    const genericMessage = GenericMessage.create({
      [GenericMessageType.EXTERNAL]: externalMessage,
      messageId,
    });

    const plainTextArray = GenericMessage.encode(genericMessage).finish();
    const recipients = await this.cryptographyService.encrypt(plainTextArray, preKeyBundles);

    return this.sendOTRMessage(sendingClientId, conversationId, recipients, base64CipherText);
  }

  private async sendGenericMessage(
    sendingClientId: string,
    conversationId: string,
    genericMessage: GenericMessage,
    userIds?: string[] | UserClientsMap,
  ): Promise<void> {
    const plainTextArray = GenericMessage.encode(genericMessage).finish();
    const preKeyBundles = await this.getPreKeyBundle(conversationId, userIds);

    if (this.shouldSendAsExternal(plainTextArray, preKeyBundles)) {
      const encryptedAsset = await AssetCryptography.encryptAsset(plainTextArray);
      return this.sendExternalGenericMessage(
        this.apiClient.validatedClientId,
        conversationId,
        encryptedAsset,
        preKeyBundles,
      );
    }

    const recipients = await this.cryptographyService.encrypt(plainTextArray, preKeyBundles);

    return this.sendOTRMessage(sendingClientId, conversationId, recipients);
  }

  // TODO: Move this to a generic "message sending class".
  private async sendOTRMessage(
    sendingClientId: string,
    conversationId: string,
    recipients: OTRRecipients,
    data?: any,
  ): Promise<void> {
    const message: NewOTRMessage = {
      data,
      recipients,
      sender: sendingClientId,
    };

    /**
     * When creating the PreKey bundles we already found out to which users we want to send a message, so we can ignore
     * missing clients. We have to ignore missing clients because there can be the case that there are clients that
     * don't provide PreKeys (clients from the Pre-E2EE era).
     */
    await this.apiClient.conversation.api.postOTRMessage(sendingClientId, conversationId, message, true);
  }

  // TODO: Move this to a generic "message sending class" and make it private.
  public async onClientMismatch(
    error: AxiosError,
    message: NewOTRMessage,
    plainTextArray: Uint8Array,
  ): Promise<NewOTRMessage> {
    if (error.response?.status === StatusCode.PRECONDITION_FAILED) {
      const {missing, deleted}: {deleted: UserClients; missing: UserClients} = error.response.data;

      const deletedUserIds = Object.keys(deleted);
      const missingUserIds = Object.keys(missing);

      if (deletedUserIds.length) {
        for (const deletedUserId of deletedUserIds) {
          for (const deletedClientId of deleted[deletedUserId]) {
            const deletedUser = message.recipients[deletedUserId];
            if (deletedUser) {
              delete deletedUser[deletedClientId];
            }
          }
        }
      }

      if (missingUserIds.length) {
        const missingPreKeyBundles = await this.apiClient.user.api.postMultiPreKeyBundles(missing);
        const reEncryptedPayloads = await this.cryptographyService.encrypt(plainTextArray, missingPreKeyBundles);
        for (const missingUserId of missingUserIds) {
          for (const missingClientId in reEncryptedPayloads[missingUserId]) {
            const missingUser = message.recipients[missingUserId];
            if (!missingUser) {
              message.recipients[missingUserId] = {};
            }
            message.recipients[missingUserId][missingClientId] = reEncryptedPayloads[missingUserId][missingClientId];
          }
        }
      }

      return message;
    }
    throw error;
  }

  private async sendButtonAction(
    payloadBundle: ButtonActionMessage,
    userIds?: string[] | UserClientsMap,
  ): Promise<ButtonActionMessage> {
    const genericMessage = GenericMessage.create({
      [GenericMessageType.BUTTON_ACTION]: ButtonAction.create(payloadBundle.content),
      messageId: payloadBundle.id,
    });

    await this.sendGenericMessage(
      this.apiClient.validatedClientId,
      payloadBundle.conversation,
      genericMessage,
      userIds,
    );

    return {
      ...payloadBundle,
      messageTimer: 0,
      state: PayloadBundleState.OUTGOING_SENT,
    };
  }

  private async sendButtonActionConfirmation(
    payloadBundle: ButtonActionConfirmationMessage,
    userIds?: string[] | UserClientsMap,
  ): Promise<ButtonActionConfirmationMessage> {
    const genericMessage = GenericMessage.create({
      [GenericMessageType.BUTTON_ACTION_CONFIRMATION]: ButtonActionConfirmation.create(payloadBundle.content),
      messageId: payloadBundle.id,
    });

    await this.sendGenericMessage(
      this.apiClient.validatedClientId,
      payloadBundle.conversation,
      genericMessage,
      userIds,
    );

    return {
      ...payloadBundle,
      messageTimer: 0,
      state: PayloadBundleState.OUTGOING_SENT,
    };
  }

  private async sendComposite(
    payloadBundle: CompositeMessage,
    userIds?: string[] | UserClientsMap,
  ): Promise<CompositeMessage> {
    const genericMessage = GenericMessage.create({
      [GenericMessageType.COMPOSITE]: Composite.create(payloadBundle.content),
      messageId: payloadBundle.id,
    });

    await this.sendGenericMessage(
      this.apiClient.validatedClientId,
      payloadBundle.conversation,
      genericMessage,
      userIds,
    );

    return {
      ...payloadBundle,
      messageTimer: 0,
      state: PayloadBundleState.OUTGOING_SENT,
    };
  }

  private async sendConfirmation(
    payloadBundle: ConfirmationMessage,
    userIds?: string[] | UserClientsMap,
  ): Promise<ConfirmationMessage> {
    const content = Confirmation.create(payloadBundle.content);

    const genericMessage = GenericMessage.create({
      [GenericMessageType.CONFIRMATION]: content,
      messageId: payloadBundle.id,
    });

    await this.sendGenericMessage(
      this.apiClient.validatedClientId,
      payloadBundle.conversation,
      genericMessage,
      userIds,
    );

    return {
      ...payloadBundle,
      messageTimer: 0,
      state: PayloadBundleState.OUTGOING_SENT,
    };
  }

  private async sendEditedText(
    payloadBundle: EditedTextMessage,
    userIds?: string[] | UserClientsMap,
  ): Promise<EditedTextMessage> {
    const editedMessage = MessageEdit.create({
      replacingMessageId: payloadBundle.content.originalMessageId,
      text: MessageToProtoMapper.mapText(payloadBundle),
    });

    const genericMessage = GenericMessage.create({
      [GenericMessageType.EDITED]: editedMessage,
      messageId: payloadBundle.id,
    });

    await this.sendGenericMessage(
      this.apiClient.validatedClientId,
      payloadBundle.conversation,
      genericMessage,
      userIds,
    );

    return {
      ...payloadBundle,
      messageTimer: 0,
      state: PayloadBundleState.OUTGOING_SENT,
    };
  }

  private async sendFileData(
    payloadBundle: FileAssetMessage,
    userIds?: string[] | UserClientsMap,
  ): Promise<FileAssetMessage> {
    if (!payloadBundle.content) {
      throw new Error('No content for sendFileData provided.');
    }

    const {asset, expectsReadConfirmation, legalHoldStatus} = payloadBundle.content;

    const remoteData = Asset.RemoteData.create({
      assetId: asset.key,
      assetToken: asset.token,
      otrKey: asset.keyBytes,
      sha256: asset.sha256,
    });

    const assetMessage = Asset.create({
      expectsReadConfirmation,
      legalHoldStatus,
      uploaded: remoteData,
    });

    assetMessage.status = AssetTransferState.UPLOADED;

    let genericMessage = GenericMessage.create({
      [GenericMessageType.ASSET]: assetMessage,
      messageId: payloadBundle.id,
    });

    const expireAfterMillis = this.messageTimer.getMessageTimer(payloadBundle.conversation);
    if (expireAfterMillis > 0) {
      genericMessage = this.createEphemeral(genericMessage, expireAfterMillis);
    }

    await this.sendGenericMessage(
      this.apiClient.validatedClientId,
      payloadBundle.conversation,
      genericMessage,
      userIds,
    );

    return {
      ...payloadBundle,
      messageTimer: this.messageTimer.getMessageTimer(payloadBundle.conversation),
      state: PayloadBundleState.OUTGOING_SENT,
    };
  }

  private async sendFileMetaData(
    payloadBundle: FileAssetMetaDataMessage,
    userIds?: string[] | UserClientsMap,
  ): Promise<FileAssetMetaDataMessage> {
    if (!payloadBundle.content) {
      throw new Error('No content for sendFileMetaData provided.');
    }

    const {expectsReadConfirmation, legalHoldStatus, metaData} = payloadBundle.content;

    const original = Asset.Original.create({
      audio: metaData.audio,
      mimeType: metaData.type,
      name: metaData.name,
      size: metaData.length,
      video: metaData.video,
    });

    const assetMessage = Asset.create({
      expectsReadConfirmation,
      legalHoldStatus,
      original,
    });

    let genericMessage = GenericMessage.create({
      [GenericMessageType.ASSET]: assetMessage,
      messageId: payloadBundle.id,
    });

    const expireAfterMillis = this.messageTimer.getMessageTimer(payloadBundle.conversation);
    if (expireAfterMillis > 0) {
      genericMessage = this.createEphemeral(genericMessage, expireAfterMillis);
    }

    await this.sendGenericMessage(
      this.apiClient.validatedClientId,
      payloadBundle.conversation,
      genericMessage,
      userIds,
    );

    return {
      ...payloadBundle,
      messageTimer: this.messageTimer.getMessageTimer(payloadBundle.conversation),
      state: PayloadBundleState.OUTGOING_SENT,
    };
  }

  private async sendFileAbort(
    payloadBundle: FileAssetAbortMessage,
    userIds?: string[] | UserClientsMap,
  ): Promise<FileAssetAbortMessage> {
    if (!payloadBundle.content) {
      throw new Error('No content for sendFileAbort provided.');
    }

    const {expectsReadConfirmation, legalHoldStatus, reason} = payloadBundle.content;

    const assetMessage = Asset.create({
      expectsReadConfirmation,
      legalHoldStatus,
      notUploaded: reason,
    });

    assetMessage.status = AssetTransferState.NOT_UPLOADED;

    let genericMessage = GenericMessage.create({
      [GenericMessageType.ASSET]: assetMessage,
      messageId: payloadBundle.id,
    });

    const expireAfterMillis = this.messageTimer.getMessageTimer(payloadBundle.conversation);
    if (expireAfterMillis > 0) {
      genericMessage = this.createEphemeral(genericMessage, expireAfterMillis);
    }

    await this.sendGenericMessage(
      this.apiClient.validatedClientId,
      payloadBundle.conversation,
      genericMessage,
      userIds,
    );

    return {
      ...payloadBundle,
      messageTimer: this.messageTimer.getMessageTimer(payloadBundle.conversation),
      state: PayloadBundleState.OUTGOING_SENT,
    };
  }

  private async sendImage(
    payloadBundle: ImageAssetMessageOutgoing,
    userIds?: string[] | UserClientsMap,
  ): Promise<ImageAssetMessage> {
    if (!payloadBundle.content) {
      throw new Error('No content for sendImage provided.');
    }

    const {asset, expectsReadConfirmation, image, legalHoldStatus} = payloadBundle.content;

    const imageMetadata = Asset.ImageMetaData.create({
      height: image.height,
      width: image.width,
    });

    const original = Asset.Original.create({
      [GenericMessageType.IMAGE]: imageMetadata,
      mimeType: image.type,
      name: null,
      size: image.data.length,
    });

    const remoteData = Asset.RemoteData.create({
      assetId: asset.key,
      assetToken: asset.token,
      otrKey: asset.keyBytes,
      sha256: asset.sha256,
    });

    const assetMessage = Asset.create({
      expectsReadConfirmation,
      legalHoldStatus,
      original,
      uploaded: remoteData,
    });

    assetMessage.status = AssetTransferState.UPLOADED;

    let genericMessage = GenericMessage.create({
      [GenericMessageType.ASSET]: assetMessage,
      messageId: payloadBundle.id,
    });

    const expireAfterMillis = this.messageTimer.getMessageTimer(payloadBundle.conversation);
    if (expireAfterMillis > 0) {
      genericMessage = this.createEphemeral(genericMessage, expireAfterMillis);
    }

    await this.sendGenericMessage(
      this.apiClient.validatedClientId,
      payloadBundle.conversation,
      genericMessage,
      userIds,
    );

    return {
      ...payloadBundle,
      content: assetMessage as AssetContent,
      messageTimer: this.messageTimer.getMessageTimer(payloadBundle.conversation),
      state: PayloadBundleState.OUTGOING_SENT,
    };
  }

  private async sendLocation(
    payloadBundle: LocationMessage,
    userIds?: string[] | UserClientsMap,
  ): Promise<LocationMessage> {
    const {expectsReadConfirmation, latitude, legalHoldStatus, longitude, name, zoom} = payloadBundle.content;

    const locationMessage = Location.create({
      expectsReadConfirmation,
      latitude,
      legalHoldStatus,
      longitude,
      name,
      zoom,
    });

    let genericMessage = GenericMessage.create({
      [GenericMessageType.LOCATION]: locationMessage,
      messageId: payloadBundle.id,
    });

    const expireAfterMillis = this.messageTimer.getMessageTimer(payloadBundle.conversation);
    if (expireAfterMillis > 0) {
      genericMessage = this.createEphemeral(genericMessage, expireAfterMillis);
    }

    await this.sendGenericMessage(
      this.apiClient.validatedClientId,
      payloadBundle.conversation,
      genericMessage,
      userIds,
    );

    return {
      ...payloadBundle,
      messageTimer: this.messageTimer.getMessageTimer(payloadBundle.conversation),
      state: PayloadBundleState.OUTGOING_SENT,
    };
  }

  private async sendKnock(payloadBundle: PingMessage, userIds?: string[] | UserClientsMap): Promise<PingMessage> {
    const content = Knock.create(payloadBundle.content);

    let genericMessage = GenericMessage.create({
      [GenericMessageType.KNOCK]: content,
      messageId: payloadBundle.id,
    });

    const expireAfterMillis = this.messageTimer.getMessageTimer(payloadBundle.conversation);
    if (expireAfterMillis > 0) {
      genericMessage = this.createEphemeral(genericMessage, expireAfterMillis);
    }

    await this.sendGenericMessage(
      this.apiClient.validatedClientId,
      payloadBundle.conversation,
      genericMessage,
      userIds,
    );

    return {
      ...payloadBundle,
      conversation: payloadBundle.conversation,
      messageTimer: this.messageTimer.getMessageTimer(payloadBundle.conversation),
      state: PayloadBundleState.OUTGOING_SENT,
    };
  }

  private async sendReaction(
    payloadBundle: ReactionMessage,
    userIds?: string[] | UserClientsMap,
  ): Promise<ReactionMessage> {
    const {legalHoldStatus, originalMessageId, type} = payloadBundle.content;

    const reaction = Reaction.create({
      emoji: type,
      legalHoldStatus,
      messageId: originalMessageId,
    });

    const genericMessage = GenericMessage.create({
      [GenericMessageType.REACTION]: reaction,
      messageId: payloadBundle.id,
    });

    await this.sendGenericMessage(
      this.apiClient.validatedClientId,
      payloadBundle.conversation,
      genericMessage,
      userIds,
    );

    return {
      ...payloadBundle,
      messageTimer: 0,
      state: PayloadBundleState.OUTGOING_SENT,
    };
  }

  private async sendSessionReset(
    payloadBundle: ResetSessionMessage,
    userIds?: string[] | UserClientsMap,
  ): Promise<ResetSessionMessage> {
    const sessionReset = GenericMessage.create({
      [GenericMessageType.CLIENT_ACTION]: ClientAction.RESET_SESSION,
      messageId: payloadBundle.id,
    });

    await this.sendGenericMessage(this.apiClient.validatedClientId, payloadBundle.conversation, sessionReset, userIds);

    return {
      ...payloadBundle,
      messageTimer: this.messageTimer.getMessageTimer(payloadBundle.conversation),
      state: PayloadBundleState.OUTGOING_SENT,
    };
  }

  private async sendCall(payloadBundle: CallMessage, userIds?: string[] | UserClientsMap): Promise<CallMessage> {
    const callMessage = Calling.create({
      content: payloadBundle.content,
    });

    const genericMessage = GenericMessage.create({
      [GenericMessageType.CALLING]: callMessage,
      messageId: payloadBundle.id,
    });

    await this.sendGenericMessage(
      this.apiClient.validatedClientId,
      payloadBundle.conversation,
      genericMessage,
      userIds,
    );

    return {
      ...payloadBundle,
      messageTimer: 0,
      state: PayloadBundleState.OUTGOING_SENT,
    };
  }

  private async sendText(payloadBundle: TextMessage, userIds?: string[] | UserClientsMap): Promise<TextMessage> {
    let genericMessage = GenericMessage.create({
      messageId: payloadBundle.id,
      [GenericMessageType.TEXT]: MessageToProtoMapper.mapText(payloadBundle),
    });

    const expireAfterMillis = this.messageTimer.getMessageTimer(payloadBundle.conversation);
    if (expireAfterMillis > 0) {
      genericMessage = this.createEphemeral(genericMessage, expireAfterMillis);
    }

    await this.sendGenericMessage(
      this.apiClient.validatedClientId,
      payloadBundle.conversation,
      genericMessage,
      userIds,
    );

    return {
      ...payloadBundle,
      messageTimer: this.messageTimer.getMessageTimer(payloadBundle.conversation),
      state: PayloadBundleState.OUTGOING_SENT,
    };
  }

  public async clearConversation(
    conversationId: string,
    timestamp: number | Date = new Date(),
    messageId: string = MessageBuilder.createId(),
  ): Promise<ClearConversationMessage> {
    if (timestamp instanceof Date) {
      timestamp = timestamp.getTime();
    }

    const content: ClearedContent = {
      clearedTimestamp: timestamp,
      conversationId,
    };

    const clearedMessage = Cleared.create(content);

    const genericMessage = GenericMessage.create({
      [GenericMessageType.CLEARED]: clearedMessage,
      messageId,
    });

    const {id: selfConversationId} = await this.getSelfConversation();

    await this.sendGenericMessage(this.apiClient.validatedClientId, selfConversationId, genericMessage);

    return {
      content,
      conversation: conversationId,
      from: this.apiClient.context!.userId,
      id: messageId,
      messageTimer: 0,
      source: PayloadBundleSource.LOCAL,
      state: PayloadBundleState.OUTGOING_SENT,
      timestamp: Date.now(),
      type: PayloadBundleType.CONVERSATION_CLEAR,
    };
  }

  public async deleteMessageLocal(conversationId: string, messageIdToHide: string): Promise<HideMessage> {
    const messageId = MessageBuilder.createId();

    const content: HiddenContent = MessageHide.create({
      conversationId,
      messageId: messageIdToHide,
    });

    const genericMessage = GenericMessage.create({
      [GenericMessageType.HIDDEN]: content,
      messageId,
    });

    const {id: selfConversationId} = await this.getSelfConversation();

    await this.sendGenericMessage(this.apiClient.validatedClientId, selfConversationId, genericMessage);

    return {
      content,
      conversation: conversationId,
      from: this.apiClient.context!.userId,
      id: messageId,
      messageTimer: this.messageTimer.getMessageTimer(conversationId),
      source: PayloadBundleSource.LOCAL,
      state: PayloadBundleState.OUTGOING_SENT,
      timestamp: Date.now(),
      type: PayloadBundleType.MESSAGE_HIDE,
    };
  }

  public async deleteMessageEveryone(
    conversationId: string,
    messageIdToDelete: string,
    userIds?: string[] | UserClientsMap,
  ): Promise<DeleteMessage> {
    const messageId = MessageBuilder.createId();

    const content: DeletedContent = MessageDelete.create({
      messageId: messageIdToDelete,
    });

    const genericMessage = GenericMessage.create({
      [GenericMessageType.DELETED]: content,
      messageId,
    });

    await this.sendGenericMessage(this.apiClient.validatedClientId, conversationId, genericMessage, userIds);

    return {
      content,
      conversation: conversationId,
      from: this.apiClient.context!.userId,
      id: messageId,
      messageTimer: this.messageTimer.getMessageTimer(conversationId),
      source: PayloadBundleSource.LOCAL,
      state: PayloadBundleState.OUTGOING_SENT,
      timestamp: Date.now(),
      type: PayloadBundleType.MESSAGE_DELETE,
    };
  }

  private shouldSendAsExternal(plainText: Uint8Array, preKeyBundles: UserPreKeyBundleMap): boolean {
    const EXTERNAL_MESSAGE_THRESHOLD_BYTES = 200 * 1024;

    let clientCount = 0;
    for (const user in preKeyBundles) {
      clientCount += Object.keys(preKeyBundles[user]).length;
    }

    const messageInBytes = new Uint8Array(plainText).length;
    const estimatedPayloadInBytes = clientCount * messageInBytes;

    return estimatedPayloadInBytes > EXTERNAL_MESSAGE_THRESHOLD_BYTES;
  }

  public leaveConversation(conversationId: string): Promise<ConversationMemberLeaveEvent> {
    return this.apiClient.conversation.api.deleteMember(conversationId, this.apiClient.context!.userId);
  }

  public async leaveConversations(conversationIds?: string[]): Promise<ConversationMemberLeaveEvent[]> {
    if (!conversationIds) {
      const conversation = await this.getConversations();
      conversationIds = conversation
        .filter(conversation => conversation.type === CONVERSATION_TYPE.REGULAR)
        .map(conversation => conversation.id);
    }

    return Promise.all(conversationIds.map(conversationId => this.leaveConversation(conversationId)));
  }

  public createConversation(name: string, otherUserIds: string | string[] = []): Promise<Conversation> {
    const ids = typeof otherUserIds === 'string' ? [otherUserIds] : otherUserIds;

    const newConversation: NewConversation = {
      name,
      users: ids,
    };

    return this.apiClient.conversation.api.postConversation(newConversation);
  }

  public async getConversations(conversationId: string): Promise<Conversation>;
  public async getConversations(conversationIds?: string[]): Promise<Conversation[]>;
  public async getConversations(conversationIds?: string | string[]): Promise<Conversation[] | Conversation> {
    if (!conversationIds || !conversationIds.length) {
      return this.apiClient.conversation.api.getAllConversations();
    }
    if (typeof conversationIds === 'string') {
      return this.apiClient.conversation.api.getConversation(conversationIds);
    }
    return this.apiClient.conversation.api.getConversationsByIds(conversationIds);
  }

  public async getAsset({assetId, assetToken, otrKey, sha256}: RemoteData): Promise<Buffer> {
    const request = await this.apiClient.asset.api.getAssetV3(assetId, assetToken);
    const encryptedBuffer = (await request.response).buffer;

    return AssetCryptography.decryptAsset({
      cipherText: Buffer.from(encryptedBuffer),
      keyBytes: Buffer.from(otrKey),
      sha256: Buffer.from(sha256),
    });
  }

  public async getUnencryptedAsset(assetId: string, assetToken?: string): Promise<ArrayBuffer> {
    const request = await this.apiClient.asset.api.getAssetV3(assetId, assetToken);
    return (await request.response).buffer;
  }

  public async addUser(conversationId: string, userId: string): Promise<string>;
  public async addUser(conversationId: string, userIds: string[]): Promise<string[]>;
  public async addUser(conversationId: string, userIds: string | string[]): Promise<string | string[]> {
    const ids = typeof userIds === 'string' ? [userIds] : userIds;
    await this.apiClient.conversation.api.postMembers(conversationId, ids);
    return userIds;
  }

  public async removeUser(conversationId: string, userId: string): Promise<string> {
    await this.apiClient.conversation.api.deleteMember(conversationId, userId);
    return userId;
  }

  /**
   * @param payloadBundle Outgoing message
   * @param userIds Only send message to specified user IDs or to certain clients of specified user IDs
   * @returns Sent message
   */
  public async send(payloadBundle: OtrMessage, userIds?: string[] | UserClientsMap) {
    switch (payloadBundle.type) {
      case PayloadBundleType.ASSET:
        return this.sendFileData(payloadBundle, userIds);
      case PayloadBundleType.ASSET_ABORT:
        return this.sendFileAbort(payloadBundle, userIds);
      case PayloadBundleType.ASSET_META:
        return this.sendFileMetaData(payloadBundle, userIds);
      case PayloadBundleType.ASSET_IMAGE:
        return this.sendImage(payloadBundle as ImageAssetMessageOutgoing, userIds);
      case PayloadBundleType.BUTTON_ACTION:
        return this.sendButtonAction(payloadBundle, userIds);
      case PayloadBundleType.BUTTON_ACTION_CONFIRMATION:
        return this.sendButtonActionConfirmation(payloadBundle, userIds);
      case PayloadBundleType.CALL:
        return this.sendCall(payloadBundle, userIds);
      case PayloadBundleType.CLIENT_ACTION: {
        if (payloadBundle.content.clientAction === ClientAction.RESET_SESSION) {
          return this.sendSessionReset(payloadBundle, userIds);
        }
        throw new Error(
          `No send method implemented for "${payloadBundle.type}" and ClientAction "${payloadBundle.content}".`,
        );
      }
      case PayloadBundleType.COMPOSITE:
        return this.sendComposite(payloadBundle, userIds);
      case PayloadBundleType.CONFIRMATION:
        return this.sendConfirmation(payloadBundle, userIds);
      case PayloadBundleType.LOCATION:
        return this.sendLocation(payloadBundle, userIds);
      case PayloadBundleType.MESSAGE_EDIT:
        return this.sendEditedText(payloadBundle, userIds);
      case PayloadBundleType.PING:
        return this.sendKnock(payloadBundle, userIds);
      case PayloadBundleType.REACTION:
        return this.sendReaction(payloadBundle, userIds);
      case PayloadBundleType.TEXT:
        return this.sendText(payloadBundle, userIds);
      default:
        throw new Error(`No send method implemented for "${payloadBundle['type']}".`);
    }
  }

  public sendTypingStart(conversationId: string): Promise<void> {
    return this.apiClient.conversation.api.postTyping(conversationId, {status: CONVERSATION_TYPING.STARTED});
  }

  public sendTypingStop(conversationId: string): Promise<void> {
    return this.apiClient.conversation.api.postTyping(conversationId, {status: CONVERSATION_TYPING.STOPPED});
  }

  public setConversationMutedStatus(
    conversationId: string,
    status: MutedStatus,
    muteTimestamp: number | Date,
  ): Promise<void> {
    if (typeof muteTimestamp === 'number') {
      muteTimestamp = new Date(muteTimestamp);
    }

    const payload: ConversationMemberUpdateData = {
      otr_muted_ref: muteTimestamp.toISOString(),
      otr_muted_status: status,
    };

    return this.apiClient.conversation.api.putMembershipProperties(conversationId, payload);
  }

  public toggleArchiveConversation(
    conversationId: string,
    archived: boolean,
    archiveTimestamp: number | Date = new Date(),
  ): Promise<void> {
    if (typeof archiveTimestamp === 'number') {
      archiveTimestamp = new Date(archiveTimestamp);
    }

    const payload: ConversationMemberUpdateData = {
      otr_archived: archived,
      otr_archived_ref: archiveTimestamp.toISOString(),
    };

    return this.apiClient.conversation.api.putMembershipProperties(conversationId, payload);
  }

  public setMemberConversationRole(
    conversationId: string,
    userId: string,
    conversationRole: DefaultConversationRoleName | string,
  ): Promise<void> {
    return this.apiClient.conversation.api.putOtherMember(userId, conversationId, {
      conversation_role: conversationRole,
    });
  }
}
