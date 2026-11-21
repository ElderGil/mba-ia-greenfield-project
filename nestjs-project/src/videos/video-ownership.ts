import type { Repository } from 'typeorm';
import type { ChannelsService } from '../channels/channels.service';
import {
  ChannelNotFoundException,
  VideoAccessDeniedException,
  VideoNotFoundException,
} from '../common/exceptions/domain.exception';
import type { Video } from './entities/video.entity';

export async function findOwnedVideo(
  videos: Repository<Video>,
  channels: ChannelsService,
  userId: string,
  videoId: string,
): Promise<Video> {
  const channel = await channels.findByUserId(userId);
  if (!channel) throw new ChannelNotFoundException();

  const video = await videos.findOne({ where: { id: videoId } });
  if (!video) throw new VideoNotFoundException();
  if (video.channel_id !== channel.id) throw new VideoAccessDeniedException();
  return video;
}
