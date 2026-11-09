//! Le sous-ensemble du format GTFS-RT (protobuf) qui sert aux retards : les
//! messages « TripUpdate ».
//!
//! Protobuf n'envoie pas de noms de champs, seulement leur numéro (`tag`) et leur
//! valeur. Il suffit donc de déclarer les champs utiles avec les numéros de la
//! spécification officielle (https://gtfs.org/documentation/realtime/proto/) :
//! `prost` décode ceux-là et ignore tous les autres. Pas besoin du compilateur
//! `protoc`.

#[derive(Clone, PartialEq, prost::Message)]
pub struct FeedMessage {
    #[prost(message, required, tag = "1")]
    pub header: FeedHeader,
    #[prost(message, repeated, tag = "2")]
    pub entity: Vec<FeedEntity>,
}

#[derive(Clone, PartialEq, prost::Message)]
pub struct FeedHeader {
    #[prost(string, required, tag = "1")]
    pub gtfs_realtime_version: String,
    /// Heure de production du flux, en secondes depuis 1970.
    #[prost(uint64, optional, tag = "3")]
    pub timestamp: Option<u64>,
}

#[derive(Clone, PartialEq, prost::Message)]
pub struct FeedEntity {
    #[prost(string, required, tag = "1")]
    pub id: String,
    #[prost(bool, optional, tag = "2")]
    pub is_deleted: Option<bool>,
    #[prost(message, optional, tag = "3")]
    pub trip_update: Option<TripUpdate>,
}

#[derive(Clone, PartialEq, prost::Message)]
pub struct TripUpdate {
    #[prost(message, required, tag = "1")]
    pub trip: TripDescriptor,
    #[prost(message, repeated, tag = "2")]
    pub stop_time_update: Vec<StopTimeUpdate>,
    #[prost(uint64, optional, tag = "4")]
    pub timestamp: Option<u64>,
}

#[derive(Clone, PartialEq, prost::Message)]
pub struct TripDescriptor {
    #[prost(string, optional, tag = "1")]
    pub trip_id: Option<String>,
    /// Jour de circulation, au format AAAAMMJJ.
    #[prost(string, optional, tag = "3")]
    pub start_date: Option<String>,
    /// Voir [`TRIP_CANCELED`] et [`TRIP_DELETED`].
    #[prost(int32, optional, tag = "4")]
    pub schedule_relationship: Option<i32>,
}

#[derive(Clone, PartialEq, prost::Message)]
pub struct StopTimeUpdate {
    #[prost(uint32, optional, tag = "1")]
    pub stop_sequence: Option<u32>,
    #[prost(message, optional, tag = "2")]
    pub arrival: Option<StopTimeEvent>,
    #[prost(message, optional, tag = "3")]
    pub departure: Option<StopTimeEvent>,
    #[prost(string, optional, tag = "4")]
    pub stop_id: Option<String>,
    /// Voir [`STOP_SKIPPED`].
    #[prost(int32, optional, tag = "5")]
    pub schedule_relationship: Option<i32>,
}

#[derive(Clone, PartialEq, prost::Message)]
pub struct StopTimeEvent {
    /// Retard en secondes (négatif = en avance).
    #[prost(int32, optional, tag = "1")]
    pub delay: Option<i32>,
    /// Heure prévue, en secondes depuis 1970.
    #[prost(int64, optional, tag = "2")]
    pub time: Option<i64>,
}

/// `TripDescriptor.schedule_relationship` : train supprimé.
pub const TRIP_CANCELED: i32 = 3;
/// `TripDescriptor.schedule_relationship` : train retiré du service.
pub const TRIP_DELETED: i32 = 7;
/// `StopTimeUpdate.schedule_relationship` : arrêt non desservi.
pub const STOP_SKIPPED: i32 = 1;
